// Adapted from pingdotgg/t3code (MIT License): apps/mobile/src/components/StatusPill.tsx
// Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES/MIT-T3Code.

import React from "react"
import { StyleSheet, Text, View } from "react-native"
import { colorWithAlpha, radius, useTheme } from "../theme"
import { MOBILE_TYPOGRAPHY } from "../lib/typography"

export type StatusPillTone = "neutral" | "success" | "info" | "danger" | "warning"

export interface StatusPillProps {
  readonly label: string
  readonly tone?: StatusPillTone
  readonly size?: "default" | "compact"
  readonly showDot?: boolean
}

export function StatusPill(props: StatusPillProps) {
  const { colors, dark } = useTheme()
  const size = props.size ?? "default"
  const tone = props.tone ?? "neutral"
  const alpha = dark ? 0.22 : 0.13
  const palette = {
    neutral: {
      background: colorWithAlpha(colors.mutedForeground, dark ? 0.16 : 0.09),
      foreground: colors.mutedForeground,
      dot: colors.mutedIcon,
    },
    success: {
      background: colorWithAlpha(colors.success, alpha),
      foreground: colors.successForeground,
      dot: colors.success,
    },
    info: {
      background: colorWithAlpha(colors.info, alpha),
      foreground: colors.infoForeground,
      dot: colors.info,
    },
    danger: {
      background: colorWithAlpha(colors.destructive, alpha),
      foreground: colors.destructive,
      dot: colors.destructive,
    },
    warning: {
      background: colorWithAlpha(colors.logo, alpha),
      foreground: colors.logo,
      dot: colors.logo,
    },
  }[tone]

  return (
    <View
      style={[
        styles.pill,
        size === "compact" ? styles.compact : styles.default,
        { backgroundColor: palette.background },
      ]}
    >
      {props.showDot === false ? null : <View style={[styles.dot, { backgroundColor: palette.dot }]} />}
      <Text
        numberOfLines={1}
        style={[
          styles.label,
          size === "compact" ? MOBILE_TYPOGRAPHY.caption : MOBILE_TYPOGRAPHY.label,
          { color: palette.foreground },
        ]}
      >
        {props.label}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.full,
    gap: 5,
  },
  default: {
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  compact: {
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: radius.full,
  },
  label: {
    fontWeight: "600",
  },
})
