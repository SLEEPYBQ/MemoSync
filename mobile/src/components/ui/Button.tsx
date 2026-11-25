// Adapted from pingdotgg/t3code (MIT License): apps/mobile/src/components/ui/Button.tsx
// Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES/MIT-T3Code.

import React from "react"
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import type { ComponentProps } from "react"
import { radius, spacing, useTheme } from "../../theme"
import { MOBILE_TYPOGRAPHY } from "../../lib/typography"

export type ButtonIconName = ComponentProps<typeof Ionicons>["name"]

export interface ButtonProps {
  readonly label: string
  readonly accessibilityLabel?: string
  readonly icon?: ButtonIconName
  readonly onPress: () => void
  readonly disabled?: boolean
  readonly accessibilityHint?: string
  readonly loading?: boolean
  readonly tone?: "primary" | "secondary" | "danger" | "text" | "contrast"
  readonly fullWidth?: boolean
  readonly size?: "default" | "compact"
  readonly shape?: "rounded" | "pill"
  readonly style?: StyleProp<ViewStyle>
  readonly labelStyle?: StyleProp<TextStyle>
}

export function Button(props: ButtonProps) {
  const { colors, dark } = useTheme()
  const tone = props.tone ?? "secondary"
  const disabled = Boolean(props.disabled || props.loading)
  const compact = props.size === "compact"

  const palette = {
    primary: { background: colors.primary, foreground: colors.primaryForeground, border: "transparent" },
    secondary: { background: colors.secondary, foreground: colors.secondaryForeground, border: colors.border },
    danger: { background: colors.destructive, foreground: colors.destructiveForeground, border: "transparent" },
    text: { background: "transparent", foreground: colors.focus, border: "transparent" },
    contrast: { background: colors.foreground, foreground: colors.background, border: "transparent" },
  }[tone]

  const backgroundColor = disabled && tone !== "text" ? colors.muted : palette.background
  const foregroundColor = disabled ? colors.mutedForeground : palette.foreground

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled, busy: Boolean(props.loading) }}
      disabled={disabled}
      onPress={props.onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.base,
        compact ? styles.compact : styles.default,
        {
          alignSelf: props.fullWidth ? "stretch" : "flex-start",
          backgroundColor,
          borderColor: palette.border,
          borderRadius: props.shape === "rounded" ? radius.base + 2 : radius.full,
          opacity: pressed ? 0.72 : 1,
        },
        tone === "primary" && !disabled && !dark ? styles.primaryLift : null,
        props.style,
      ]}
    >
      {props.loading ? (
        <ActivityIndicator size="small" color={foregroundColor} />
      ) : props.icon ? (
        <Ionicons name={props.icon} size={compact ? 16 : 18} color={foregroundColor} />
      ) : null}
      <Text
        numberOfLines={1}
        style={[
          styles.label,
          compact ? MOBILE_TYPOGRAPHY.label : MOBILE_TYPOGRAPHY.bodySmall,
          { color: foregroundColor },
          props.labelStyle,
        ]}
      >
        {props.label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  base: {
    minWidth: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm - 1,
    borderWidth: StyleSheet.hairlineWidth,
  },
  default: {
    minHeight: 46,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 1,
  },
  compact: {
    minHeight: 38,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 1,
  },
  label: {
    flexShrink: 1,
    fontWeight: "600",
    textAlign: "center",
  },
  primaryLift: {
    shadowColor: "#3c332d",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.12,
    shadowRadius: 7,
    elevation: 1,
  },
  toolbarButton: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm + 2,
  },
  toolbarLabel: {
    ...MOBILE_TYPOGRAPHY.footnote,
    fontWeight: "500",
  },
})

/** A small circular action button in the spirit of T3's composer control. */
export function CircleActionButton(props: {
  readonly accessibilityLabel: string
  readonly icon: ButtonIconName
  readonly onPress: () => void
  readonly disabled?: boolean
  readonly loading?: boolean
  readonly variant?: "primary" | "danger" | "secondary"
  readonly size?: number
  readonly style?: StyleProp<ViewStyle>
}) {
  const { colors } = useTheme()
  const diameter = props.size ?? 38
  const variant = props.variant ?? "primary"
  const backgroundColor = props.disabled
    ? colors.muted
    : variant === "primary"
      ? colors.primary
      : variant === "danger"
        ? colors.destructive
        : colors.secondary
  const iconColor = props.disabled
    ? colors.mutedForeground
    : variant === "primary"
      ? colors.primaryForeground
      : variant === "danger"
        ? colors.destructiveForeground
        : colors.secondaryForeground

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ disabled: Boolean(props.disabled), busy: Boolean(props.loading) }}
      disabled={props.disabled || props.loading}
      onPress={props.onPress}
      hitSlop={6}
      style={({ pressed }) => [
        {
          width: diameter,
          height: diameter,
          borderRadius: diameter / 2,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor,
          opacity: pressed ? 0.72 : 1,
        },
        props.style,
      ]}
    >
      {props.loading ? (
        <ActivityIndicator size="small" color={iconColor} />
      ) : (
        <Ionicons name={props.icon} size={Math.round(diameter * 0.48)} color={iconColor} />
      )}
    </Pressable>
  )
}

export function ToolbarLabelButton(props: {
  readonly label: string
  readonly icon?: ButtonIconName
  readonly onPress?: () => void
  readonly disabled?: boolean
  readonly selected?: boolean
  readonly style?: StyleProp<ViewStyle>
}) {
  const { colors } = useTheme()
  return (
    <Pressable
      accessibilityRole={props.onPress ? "button" : undefined}
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: Boolean(props.disabled), selected: props.selected }}
      disabled={props.disabled || !props.onPress}
      onPress={props.onPress}
      hitSlop={5}
      style={({ pressed }) => [
        styles.toolbarButton,
        {
          backgroundColor: props.selected ? colors.secondary : "transparent",
          opacity: props.disabled ? 0.45 : pressed ? 0.65 : 1,
        },
        props.style,
      ]}
    >
      {props.icon ? <Ionicons name={props.icon} size={16} color={props.selected ? colors.foreground : colors.mutedIcon} /> : null}
      <Text style={[styles.toolbarLabel, { color: props.selected ? colors.foreground : colors.mutedForeground }]} numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  )
}

