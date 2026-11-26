// Adapted from pingdotgg/t3code (MIT License): apps/mobile/src/lib/typography.ts
// Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES/MIT-T3Code.

/**
 * MemoSync mobile type scale. T3's role structure is retained, but the values
 * are remapped to MemoSync's quieter macOS-like scale and use the system font.
 */
export const MOBILE_TYPOGRAPHY = {
  micro: { fontSize: 11, lineHeight: 14 },
  caption: { fontSize: 12, lineHeight: 16 },
  label: { fontSize: 13, lineHeight: 18 },
  footnote: { fontSize: 14, lineHeight: 20 },
  bodySmall: { fontSize: 15, lineHeight: 22 },
  body: { fontSize: 16, lineHeight: 23 },
  headline: { fontSize: 18, lineHeight: 24, fontWeight: "600" },
  title: { fontSize: 21, lineHeight: 27, fontWeight: "600" },
  largeTitle: { fontSize: 26, lineHeight: 32, fontWeight: "600" },
  display: { fontSize: 30, lineHeight: 36, fontWeight: "600" },
} as const

export type MobileTextRole = keyof typeof MOBILE_TYPOGRAPHY

export const MOBILE_CODE_SURFACE = {
  rowHeight: 22,
  gutterWidth: 46,
  codePadding: 10,
  textVerticalInset: 2,
  fontSize: MOBILE_TYPOGRAPHY.caption.fontSize,
  lineNumberFontSize: MOBILE_TYPOGRAPHY.micro.fontSize,
} as const
