// Adapted from pingdotgg/t3code (MIT License): apps/mobile/src/components/ui/ListRowLayout.tsx
// Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES/MIT-T3Code.

import React, { type ReactNode } from "react"
import { Platform, StyleSheet, Text, useWindowDimensions, View } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import type { ButtonIconName } from "./Button"
import { radius, spacing, useTheme } from "../../theme"
import { MOBILE_TYPOGRAPHY } from "../../lib/typography"

export interface ListRowContentProps {
  readonly icon?: ButtonIconName
  /** Drawn in the leading column for marks a single symbol can't express. */
  readonly leading?: ReactNode
  readonly label: string
  readonly description?: string
  readonly detail?: string
  /** Rich secondary content under the description. */
  readonly meta?: ReactNode
  readonly disabled?: boolean
}

export function ListRowLayout({
  icon,
  leading,
  label,
  description,
  detail,
  meta,
  disabled,
  accessory,
  tone = "default",
}: ListRowContentProps & {
  readonly accessory?: ReactNode
  readonly tone?: "default" | "danger"
}) {
  const { colors } = useTheme()
  const { fontScale } = useWindowDimensions()
  const stackDetail = fontScale >= 1.45
  const labelColor = tone === "danger" ? colors.destructive : colors.foreground

  return (
    <View style={[styles.row, description ? styles.rowWithDescription : null, disabled ? styles.disabled : null]}>
      {icon ? (
        <View style={styles.leadingSlot}>
          <Ionicons
            name={icon}
            size={Platform.OS === "android" ? 21 : 20}
            color={tone === "danger" ? colors.destructive : colors.mutedForeground}
          />
        </View>
      ) : leading ? (
        <View style={styles.leadingSlot}>{leading}</View>
      ) : null}

      <View style={styles.content}>
        <Text style={[styles.label, { color: labelColor }]} numberOfLines={1}>
          {label}
        </Text>
        {description ? (
          <Text style={[styles.description, { color: colors.mutedForeground }]} numberOfLines={2}>
            {description}
          </Text>
        ) : null}
        {meta}
        {detail && stackDetail ? (
          <Text style={[styles.description, { color: colors.mutedForeground }]} numberOfLines={1} ellipsizeMode="middle">
            {detail}
          </Text>
        ) : null}
      </View>

      {detail && !stackDetail ? (
        <Text style={[styles.detail, { color: colors.mutedForeground }]} numberOfLines={1} ellipsizeMode="middle">
          {detail}
        </Text>
      ) : null}
      {accessory}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  rowWithDescription: {
    minHeight: 70,
    paddingVertical: spacing.md - 1,
  },
  disabled: {
    opacity: 0.45,
  },
  leadingSlot: {
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
  },
  content: {
    minWidth: 0,
    flex: 1,
    gap: spacing.xxs,
  },
  label: {
    ...MOBILE_TYPOGRAPHY.body,
    fontWeight: "500",
  },
  description: {
    ...MOBILE_TYPOGRAPHY.label,
  },
  detail: {
    ...MOBILE_TYPOGRAPHY.footnote,
    maxWidth: "38%",
    flexShrink: 1,
    textAlign: "right",
  },
})
