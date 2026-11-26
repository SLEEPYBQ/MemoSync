// Adapted from pingdotgg/t3code (MIT License): apps/mobile/src/features/threads/PendingApprovalCard.tsx
// Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES/MIT-T3Code.

import React, { type ReactNode } from "react"
import { ScrollView, StyleSheet, Text, View } from "react-native"
import { Button } from "../../components/ui/Button"
import { radius, spacing, useTheme } from "../../theme"
import { MOBILE_TYPOGRAPHY } from "../../lib/typography"

export interface PendingApprovalOption {
  readonly key: string
  readonly label: string
  readonly description?: string
  readonly tone?: "primary" | "secondary" | "danger"
  readonly result: unknown
  readonly disabled?: boolean
}

export interface PendingApprovalCardProps {
  readonly title: string
  readonly eyebrow?: string
  readonly detail?: string
  readonly body?: ReactNode
  readonly warning?: string
  readonly options: ReadonlyArray<PendingApprovalOption>
  readonly disabled?: boolean
  readonly respondingKey?: string | null
  readonly unavailableReason?: string
  readonly onRespond: (option: PendingApprovalOption) => Promise<unknown> | unknown
}

/**
 * Interactive approval card: potentially long provider content is capped in
 * its own scroll region while the decision row stays pinned and reachable.
 */
export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const { colors } = useTheme()
  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.header}>
        <Text style={[styles.eyebrow, { color: colors.mutedForeground }]}>
          {(props.eyebrow ?? "Approval needed").toUpperCase()}
        </Text>
        <Text style={[styles.title, { color: colors.foreground }]}>{props.title}</Text>
        {props.detail ? <Text style={[styles.detail, { color: colors.mutedForeground }]}>{props.detail}</Text> : null}
      </View>

      {props.body ? (
        <ScrollView
          style={styles.bodyScroll}
          contentContainerStyle={styles.bodyContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          {props.body}
        </ScrollView>
      ) : null}

      {props.warning ? <Text style={[styles.warning, { color: colors.logo }]}>{props.warning}</Text> : null}
      {props.unavailableReason ? (
        <Text style={[styles.unavailable, { color: colors.mutedForeground }]}>{props.unavailableReason}</Text>
      ) : null}

      <ScrollView
        style={[styles.actionBar, { borderTopColor: colors.border, backgroundColor: colors.sidebar }]}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.actionsContent}>
          {props.options.map((option) => (
            <Button
              key={option.key}
              label={option.label}
              description={option.description}
              accessibilityLabel={option.description ? `${option.label}. ${option.description}` : option.label}
              tone={option.tone ?? (option.key === "accept" ? "primary" : "secondary")}
              size="compact"
              fullWidth
              disabled={props.disabled || option.disabled || props.respondingKey != null}
              loading={props.respondingKey === option.key}
              onPress={() => void props.onRespond(option)}
              style={styles.actionButton}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
    gap: spacing.xs,
  },
  eyebrow: {
    ...MOBILE_TYPOGRAPHY.caption,
    fontWeight: "700",
    letterSpacing: 0.8,
  },
  title: {
    ...MOBILE_TYPOGRAPHY.headline,
  },
  detail: {
    ...MOBILE_TYPOGRAPHY.footnote,
  },
  bodyScroll: {
    maxHeight: 220,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  bodyContent: {
    paddingVertical: spacing.xs,
  },
  warning: {
    ...MOBILE_TYPOGRAPHY.label,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  unavailable: {
    ...MOBILE_TYPOGRAPHY.label,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  actionBar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.sm,
    // Long single-select option sets remain answerable without letting the
    // action list consume the transcript or hide the question body.
    maxHeight: 190,
    flexGrow: 0,
  },
  actionsContent: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  actionButton: {
    alignSelf: "stretch",
  },
})
