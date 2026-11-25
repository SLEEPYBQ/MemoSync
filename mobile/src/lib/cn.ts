// Adapted from pingdotgg/t3code (MIT License): apps/mobile/src/lib/cn.ts
// Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES/MIT-T3Code.

/**
 * React Native has no class-name cascade here, so the T3 `cn` composition
 * point becomes a tiny conditional-style combinator. It preserves the same
 * call-site ergonomics for StyleSheet objects without pulling in a classname
 * runtime.
 */
export function cn<T>(...inputs: Array<T | false | null | undefined>): T[] {
  return inputs.filter(Boolean) as T[]
}
