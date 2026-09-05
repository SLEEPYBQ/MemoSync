export const STUDY_INSTRUCTION_GUARD_RULE_VERSION = "token-lcs-v1"

const MIN_CONTIGUOUS_TOKENS = 8
const MIN_LCS_COMPARISON_TOKENS = 12
const MIN_LCS_RATIO = 0.75

export interface StudyInstructionOverlapAssessment {
  rejected: boolean
  ruleVersion: typeof STUDY_INSTRUCTION_GUARD_RULE_VERSION
  longestContiguousRun: number
  lcsRatio: number
  reference: `paragraph_${number}` | "full_brief" | null
}

export function tokenizeStudyInstruction(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu) ?? []
}

function overlapMetrics(prompt: readonly string[], reference: readonly string[]) {
  if (prompt.length === 0 || reference.length === 0) {
    return { longestContiguousRun: 0, lcsLength: 0, lcsRatio: 0 }
  }

  // Both DPs retain one reference-sized row. Briefs are short, while a user
  // prompt can be long; memory therefore stays bounded by instruction size.
  let contiguousPrevious = new Uint32Array(reference.length + 1)
  let contiguousCurrent = new Uint32Array(reference.length + 1)
  let lcsPrevious = new Uint32Array(reference.length + 1)
  let lcsCurrent = new Uint32Array(reference.length + 1)
  let longestContiguousRun = 0
  for (const promptToken of prompt) {
    contiguousCurrent.fill(0)
    lcsCurrent[0] = 0
    for (let j = 1; j <= reference.length; j += 1) {
      if (promptToken === reference[j - 1]) {
        contiguousCurrent[j] = contiguousPrevious[j - 1]! + 1
        lcsCurrent[j] = lcsPrevious[j - 1]! + 1
        longestContiguousRun = Math.max(longestContiguousRun, contiguousCurrent[j]!)
      } else {
        lcsCurrent[j] = Math.max(lcsPrevious[j]!, lcsCurrent[j - 1]!)
      }
    }
    ;[contiguousPrevious, contiguousCurrent] = [contiguousCurrent, contiguousPrevious]
    ;[lcsPrevious, lcsCurrent] = [lcsCurrent, lcsPrevious]
  }

  const lcsLength = lcsPrevious[reference.length]!
  const denominator = Math.min(prompt.length, reference.length)
  return {
    longestContiguousRun,
    lcsLength,
    lcsRatio: denominator === 0 ? 0 : lcsLength / denominator,
  }
}

export function assessStudyInstructionOverlap(
  prompt: string,
  brief: readonly string[],
): StudyInstructionOverlapAssessment {
  const promptTokens = tokenizeStudyInstruction(prompt)
  const references = [
    ...brief.map((paragraph, index) => ({
      name: `paragraph_${index + 1}` as const,
      tokens: tokenizeStudyInstruction(paragraph),
    })),
    { name: "full_brief" as const, tokens: tokenizeStudyInstruction(brief.join(" ")) },
  ]

  let best: Omit<StudyInstructionOverlapAssessment, "ruleVersion"> = {
    rejected: false,
    longestContiguousRun: 0,
    lcsRatio: 0,
    reference: null,
  }
  let bestStrength = -1

  for (const reference of references) {
    const metrics = overlapMetrics(promptTokens, reference.tokens)
    const enoughForLcs = Math.min(promptTokens.length, reference.tokens.length) >= MIN_LCS_COMPARISON_TOKENS
    const rejected = metrics.longestContiguousRun >= MIN_CONTIGUOUS_TOKENS
      || (enoughForLcs && metrics.lcsRatio >= MIN_LCS_RATIO)
    const strength = Math.max(
      metrics.longestContiguousRun / MIN_CONTIGUOUS_TOKENS,
      enoughForLcs ? metrics.lcsRatio / MIN_LCS_RATIO : 0,
    )
    if (strength <= bestStrength) continue
    bestStrength = strength
    best = {
      rejected,
      longestContiguousRun: metrics.longestContiguousRun,
      lcsRatio: metrics.lcsRatio,
      reference: reference.name,
    }
  }

  return { ...best, ruleVersion: STUDY_INSTRUCTION_GUARD_RULE_VERSION }
}
